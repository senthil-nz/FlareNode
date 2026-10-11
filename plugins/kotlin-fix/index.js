const { withProjectBuildGradle, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withKotlinFix(config) {
  config = withDangerousMod(config, [
    'android',
    async function totalSplashOverkill(config) {
      try {
        const projectRoot = process.cwd();
        const densities = ['drawable', 'drawable-hdpi', 'drawable-mdpi', 'drawable-xhdpi', 'drawable-xxhdpi', 'drawable-xxxhdpi'];
        
        const dummyContent = `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="@android:color/white" />
</layer-list>`;

        densities.forEach(dirName => {
          const dirPath = path.join(projectRoot, 'android/app/src/main/res', dirName);
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
          }
          const filePath = path.join(dirPath, 'splashscreen.xml');
          fs.writeFileSync(filePath, dummyContent, 'utf8');
          console.log(`[KotlinFix] Created splashscreen.xml in ${dirName}`);
        });

        const valuesDir = path.join(projectRoot, 'android/app/src/main/res/values');
        if (fs.existsSync(valuesDir)) {
          const files = fs.readdirSync(valuesDir);
          files.forEach(file => {
            if (file.endsWith('.xml')) {
              const p = path.join(valuesDir, file);
              let c = fs.readFileSync(p, 'utf8');
              if (c.includes('@drawable/splashscreen')) {
                fs.writeFileSync(p, c.replace(/@drawable\/splashscreen/g, '#FFFFFF'), 'utf8');
                console.log(`[KotlinFix] Scrubbed ${file}`);
              }
            }
          });
        }
      } catch (e) {
        console.log(`[KotlinFix] Overkill failed: ${e.message}`);
      }
      return config;
    },
  ]);

  return withProjectBuildGradle(config, (config) => {
    if (config.modResults.contents.includes('resolutionStrategy')) {
      config.modResults.contents = config.modResults.contents.replace(
        /resolutionStrategy\s*\{([\s\S]*?)\}/,
        (match, content) => {
          return `resolutionStrategy {
            ${content.trimEnd()}
            force "org.jetbrains.kotlin:kotlin-stdlib:1.9.0"
            force "org.jetbrains.kotlin:kotlin-reflect:1.9.0"
        }`;
        }
      );
    } else {
      const allprojectsBlock = `
allprojects {
    configurations.all {
        resolutionStrategy {
            force "org.jetbrains.kotlin:kotlin-stdlib:1.9.0"
            force "org.jetbrains.kotlin:kotlin-reflect:1.9.0"
        }
    }
}`;
      config.modResults.contents += `\n${allprojectsBlock}\n`;
    }
    return config;
  });
};
