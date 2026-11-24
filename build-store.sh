#!/bin/sh
# Builds the Chrome Web Store zip: no brands.js, so the experimental no-name filter is left out.
set -e
cd "$(dirname "$0")"
v=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')
rm -rf dist/store && mkdir -p dist/store/icons
cp content.js styles.css dist/store/
cp icons/*.png dist/store/icons/
python3 -c 'import json
m=json.load(open("manifest.json"))
m["content_scripts"][0]["js"]=["content.js"]
open("dist/store/manifest.json","w").write(json.dumps(m,indent=2)+"\n")'
rm -f "dist/review-sort-$v.zip"
(cd dist/store && zip -qr "../review-sort-$v.zip" .)
echo "built dist/review-sort-$v.zip"
