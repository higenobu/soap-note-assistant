#!/bin/sh
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install -d -m 755 /var/www/soap-note-assistant
for name in index.html style.css core.js app.js; do
    install -m 644 "$project_root/static/$name" "/var/www/soap-note-assistant/$name"
done
printf '%s\n' 'Installed public files. Apache configuration was not changed.'
