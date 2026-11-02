# Alternative: api.kcg.edu HTTPS gateway is Apache on the SAME host as ASR.
# Include before an existing broad ProxyPass mapping, inside the HTTPS VirtualHost.
<Location "/soap-api/">
    LimitRequestBody 33554432
</Location>
ProxyPass "/soap-api/" "http://127.0.0.1:8003/soap-api/" connectiontimeout=15 timeout=1800 retry=0 disablereuse=On
ProxyPassReverse "/soap-api/" "http://127.0.0.1:8003/soap-api/"
