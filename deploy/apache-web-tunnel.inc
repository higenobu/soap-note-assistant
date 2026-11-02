# Include inside the existing llm-jp.com :443 VirtualHost.
RedirectMatch 302 "^/soap$" "/soap/"
Alias "/soap/" "/var/www/soap-note-assistant/"
<Directory "/var/www/soap-note-assistant">
    DirectoryIndex index.html
    Options -Indexes
    AllowOverride None
    Require all granted
</Directory>
# EC2 loopback port 18003 is provided by an encrypted reverse SSH tunnel from deepstation.
<Location "/soap-api/">
    LimitRequestBody 33554432
</Location>
ProxyPass "/soap-api/" "http://127.0.0.1:18003/soap-api/" connectiontimeout=15 timeout=1800 retry=0 disablereuse=On
ProxyPassReverse "/soap-api/" "http://127.0.0.1:18003/soap-api/"
# Preserve the existing /llmjp/ HTTPS proxy for SOAP classification.
# Do not install this together with the alternative apache-web.inc.
