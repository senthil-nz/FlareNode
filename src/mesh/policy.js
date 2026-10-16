import { versionMillis } from './clock.js';
import { verifyCertificate, verifyCancellation, verifyRecord, certificateId } from './identity.js';

/**
 * The rules for what each responder may write, checked on every phone.
 *
 * A record is only accepted if:
 *
 *   1. it is signed,
 *   2. the signer's certificate was issued by the Mothership, and had neither
 *      run out nor been cancelled when the record was written,
 *   3. the signature matches, and
 *   4. the signer is allowed to make that change.
 *
 * Rule 4, by collection:
 *
 *   tactical_markers   You may add markers as yourself, and change or remove
 *                      your own. An admin may change or remove any.
 *   connectivity_logs  You may log a dead zone as yourself. Only an admin may
 *                      change or clear one.
 *   anything else      Any responder with a valid certificate.
 *
 * A marker's id must start with its author's id, and a dead zone's with its
 * reporter's. Without that, someone could "add" a record that reuses another
 * responder's id while naming themselves as author, and so overwrite it on
 * any phone that had not yet seen the original.
 *
 * Because every phone applies the same rules to every record it is offered,
 * a record that breaks them is not stored and not passed on, wherever it
 * came from.
 *
 * Certificates travel in their own collection. A certificate needs no signer:
 * it carries the Mothership's signature and is checked against that.
 *
 * So do cancellations. An admin cancels a responder's certificate from the
 * dashboard (or by removing the responder, or changing their role), and the
 * Mothership signs a notice that spreads through the mesh like any record.
 * From the moment it names, nothing signed with that key is accepted. What
 * was signed before stays valid, so a departing responder's hazard markers
 * do not vanish with them.
 */

export const CERTIFICATES = 'mesh_certs';
export const CANCELLATIONS = 'mesh_cancellations';

// Phone clocks differ; allow this much when checking a certificate's dates
const CLOCK_ALLOWANCE_MS = 10 * 60 * 1000;

const allow = { ok: true };
const deny = (reason) => ({ ok: false, reason });

/**
 * The version every phone gives a certificate's record, so they all agree.
 *
 * It follows the expiry date, not the start date. A renewed certificate keeps
 * the start date of the one before it and runs for longer, and must replace
 * it. If renewal moved the start date instead, everything the responder wrote
 * before the renewal would look as if it was written before they were
 * certified, and a phone meeting those records for the first time would
 * refuse them.
 */
export const certificateVersion = (cert) => `${String(cert.expires).padStart(15, '0')}:00000:authority`;

/**
 * The version every phone gives a cancellation's record. The earliest
 * cancellation of a certificate is the strictest, so an earlier one replaces
 * a later one and not the other way round.
 */
export const cancellationVersion = (cancellation) => `${String(MAX_TIME - cancellation.at).padStart(15, '0')}:00000:authority`;
const MAX_TIME = 999999999999999;

/** A cancellation as a record in the cancellations collection. */
export const cancellationRecord = (cancellation) => ({
  collection: CANCELLATIONS,
  id: cancellation.cert,
  version: cancellationVersion(cancellation),
  fields: { ...cancellation, _id: cancellation.cert },
});

/** A certificate as a record in the certificates collection. */
export const certificateRecord = (cert) => ({
  collection: CERTIFICATES,
  id: certificateId(cert),
  version: certificateVersion(cert),
  fields: { ...cert, _id: certificateId(cert) },
});

export function createPolicy({ ed, authorityKey }) {
  // Checking a signature is slow on a phone; remember the ones that passed
  const checked = new Set();

  const signatureHolds = (cert, record) => {
    const key = `${record.collection}|${record.id}|${record.version}|${record.auth.sig}`;
    if (checked.has(key)) return true;
    if (!verifyRecord(ed, cert, record)) return false;
    checked.add(key);
    if (checked.size > 5000) checked.delete(checked.values().next().value);
    return true;
  };

  return {
    /**
     * Decides whether `record` may be stored.
     *   existing         the record currently held under the same id, if any
     *   getCertificate   looks up a certificate by id among those already accepted
     *   getCancellation  looks up a certificate's cancellation, if there is one
     */
    check(record, existing, getCertificate, getCancellation = () => null) {
      if (record.collection === CERTIFICATES) {
        const { _id, ...cert } = record.fields;
        if (record.id !== certificateId(cert)) return deny('certificate filed under the wrong id');
        if (record.version !== certificateVersion(cert)) return deny('certificate with an unexpected version');
        if (!verifyCertificate(ed, authorityKey, cert)) return deny('certificate not issued by the Mothership');
        return allow;
      }

      if (record.collection === CANCELLATIONS) {
        const { _id, ...cancellation } = record.fields;
        if (record.id !== cancellation.cert) return deny('cancellation filed under the wrong id');
        if (record.version !== cancellationVersion(cancellation)) return deny('cancellation with an unexpected version');
        if (!verifyCancellation(ed, authorityKey, cancellation)) return deny('cancellation not issued by the Mothership');
        return allow;
      }

      if (!record.auth || typeof record.auth.k !== 'string' || typeof record.auth.sig !== 'string') return deny('not signed');
      const stored = getCertificate(record.auth.k);
      if (!stored) return deny('signer is not known');
      const { _id, ...cert } = stored;

      // Only the end of the certificate's life is enforced. A start date would
      // add nothing: back-dating a record gains its author nothing, as older
      // versions lose to newer ones. And it does harm: when a certificate is
      // reissued with a later start, everything its holder wrote before then
      // is refused by any phone meeting those records for the first time.
      const written = versionMillis(record.version);
      if (written > cert.expires + CLOCK_ALLOWANCE_MS) {
        return deny('written after the certificate of its signer ran out');
      }
      const cancelled = getCancellation(record.auth.k);
      if (cancelled && written > cancelled.at) {
        return deny('written after the certificate of its signer was cancelled');
      }
      if (!signatureHolds(cert, record)) return deny('signature does not match');

      const signer = cert.id;
      if (cert.role === 'admin') return allow;

      const fields = record.fields;
      if (record.collection === 'tactical_markers') {
        if (fields.author_id !== signer) return deny('a marker may only be changed by its author or an admin');
        if (!record.id.startsWith(`${signer}-`)) return deny('a marker id must start with its author');
        if (existing && existing.fields.author_id !== signer) return deny('a marker may only be changed by its author or an admin');
        return allow;
      }
      if (record.collection === 'connectivity_logs') {
        if (existing) return deny('a dead zone may only be changed or cleared by an admin');
        if (fields.deleted) return deny('a dead zone may only be cleared by an admin');
        if (fields.reporter_id !== signer) return deny('a dead zone must be logged under your own name');
        if (!record.id.startsWith(`gap_${signer}_`)) return deny('a dead zone id must start with its reporter');
        return allow;
      }
      return allow;
    },
  };
}
