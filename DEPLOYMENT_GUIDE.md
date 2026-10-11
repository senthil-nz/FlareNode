# 🚀 FlareNode Mothership: Deployment Guide

This guide provides step-by-step instructions to build the Mothership Server image and deploy it into a local Kubernetes (K8s) cluster.

## 🛠️ Prerequisites

Before starting, ensure you have the following installed and configured:
- **Docker**: For building the container image.
- **kubectl**: The Kubernetes command-line tool.
- **Local K8s Cluster**: Minikube, Kind, or MicroK8s.
- **Ingress Controller** (Optional): If you want to use a domain name instead of a NodePort.

---

## 📦 Part 1: Docker Image Creation

The Mothership Server is containerized using a slim Node-Alpine image to keep the footprint small.

### 1. Build the Image
Navigate to the server directory and build the image:
```bash
cd FlareNode/mothership-server
docker build -t flarenode-mothership:latest .
```

### 2. Tag and Push (For Remote Clusters)
If you are deploying to a remote cluster (not local), you must push the image to a registry (e.g., Docker Hub or GHCR):
```bash
docker tag flarenode-mothership:latest your-registry/flarenode-mothership:latest
docker push your-registry/flarenode-mothership:latest
```

*Note: For local clusters like Minikube, you can load the image directly:*
```bash
minikube image load flarenode-mothership:latest
```

---

## 🏛️ Part 2: Kubernetes Deployment

The deployment is split into three phases: Database $\rightarrow$ Configuration $\rightarrow$ API.

### 1. Deploy PostgreSQL (The Data Layer)
The server requires a PostgreSQL database for persistence. Apply the manifest first:
```bash
kubectl apply -f k8s/postgres.yaml
```
**Verify DB is running:**
```bash
kubectl get pods # Look for the postgres pod to be in 'Running' state
```

### 2. Configure Environment Variables
The `configmap.yaml` contains the essential environment variables, including the database connection string and JWT secrets.
```bash
kubectl apply -f k8s/configmap.yaml
```

### 3. Deploy the Mothership API
Now, deploy the Node.js application and its service:
```bash
kubectl apply -f k8s/api.yaml
```

---

## 🔍 Part 3: Verification & Testing

### 1. Check Deployment Status
Check that the API pods are healthy:
```bash
kubectl get pods -l app=mothership-api
```

### 2. Access the API
If you are using a `NodePort` service, find the port:
```bash
kubectl get svc mothership-service
```
If the port is `3000`, you can access it at `http://<cluster-ip>:3000`.

### 3. Test the Health Check
Run a quick curl request to verify the server is responding:
```bash
curl http://localhost:3000/api/export/geojson
```

---

## ⚠️ Troubleshooting

| Issue | Cause | Solution |
| :--- | :--- | :--- |
| `ImagePullBackOff` | K8s cannot find the Docker image. | Ensure you ran `minikube image load` or pushed the image to a reachable registry. |
| `CrashLoopBackOff` | API failed to connect to Postgres. | Check if the postgres pod is running and that the `DATABASE_URL` in the ConfigMap is correct. |
| `403 Forbidden` | Invalid API Key. | Ensure the `VALIDATOR_API_KEY` in the ConfigMap matches your request header. |

---
*Engineered by moltis 🤖*
