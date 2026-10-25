"""Reads zip files the way an ordinary unzip tool would: every entry's CRC checked.
Usage: python3 zipcheck.py <file.zip>...; prints {zip: {name: content as latin-1}} as JSON."""
import json
import sys
import zipfile

out = {}
for path in sys.argv[1:]:
    with zipfile.ZipFile(path) as z:
        bad = z.testzip()
        if bad:
            sys.exit(f"{path}: bad CRC in {bad}")
        out[path] = {i.filename: z.read(i).decode("latin-1") for i in z.infolist()}
print(json.dumps(out))
