# Only if the api.kcg.edu HTTPS gateway is Nginx on the SAME host as ASR.
# Include inside that gateway's existing HTTPS server block, before broad regex routes.
location ^~ /soap-api/ {
    proxy_pass http://127.0.0.1:8003;
    client_max_body_size 32m;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_http_version 1.1;
    proxy_request_buffering off;
    proxy_connect_timeout 15s;
    proxy_read_timeout 1800s;
    proxy_send_timeout 1800s;
    proxy_next_upstream off;
    proxy_cache off;
    proxy_buffering off;
    access_log off;
}
