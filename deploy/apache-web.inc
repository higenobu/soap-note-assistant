# Include inside the existing llm-jp.com :443 VirtualHost.
RedirectMatch 302 "^/soap$" "/soap/"
Alias "/soap/" "/var/www/soap-note-assistant/"
<Directory "/var/www/soap-note-assistant">
    DirectoryIndex index.html
    Options -Indexes
    AllowOverride None
    Require all granted
</Directory>
# api.kcg.edu must expose this route to the deepstation ASR service first.
<Location "/soap-api/">
    LimitRequestBody 33554432
</Location>
ProxyPass "/soap-api/" "https://api.kcg.edu/soap-api/" connectiontimeout=15 timeout=1800 retry=0 disablereuse=On
ProxyPassReverse "/soap-api/" "https://api.kcg.edu/soap-api/"
# Reuse existing SSLProxyEngine/CA verification and /llmjp/ proxy settings.
