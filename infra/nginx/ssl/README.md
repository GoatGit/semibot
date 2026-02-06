# SSL Certificates Directory

This directory is used to store SSL/TLS certificates for production HTTPS.

## Required Files

- `cert.pem` - SSL certificate (or certificate chain)
- `key.pem` - Private key

## Generating Self-Signed Certificates (Development/Testing Only)

```bash
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout key.pem \
  -out cert.pem \
  -subj "/C=CN/ST=State/L=City/O=Organization/CN=localhost"
```

## Using Let's Encrypt (Production)

For production, use certbot to obtain free SSL certificates:

```bash
# Install certbot
apt-get install certbot

# Obtain certificate
certbot certonly --standalone -d your-domain.com

# Certificates will be at:
# /etc/letsencrypt/live/your-domain.com/fullchain.pem
# /etc/letsencrypt/live/your-domain.com/privkey.pem

# Copy to this directory
cp /etc/letsencrypt/live/your-domain.com/fullchain.pem ./cert.pem
cp /etc/letsencrypt/live/your-domain.com/privkey.pem ./key.pem
```

## Security Notes

- **NEVER** commit real certificates to version control
- Keep private keys secure with proper file permissions (chmod 600)
- Rotate certificates before expiration
- Use strong key sizes (2048-bit RSA minimum, prefer 4096-bit or ECDSA)
