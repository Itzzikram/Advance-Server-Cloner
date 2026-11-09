# Proxy Setup Guide

## Adding Multiple Proxies

You can add multiple proxies to the cloner. They are automatically rotated using round-robin rotation.

## Format

Each proxy should be in the format: `IP:PORT:USERNAME:PASSWORD` (username/password optional).

## Adding Proxies to Your Configuration

When running the tool interactively, you can paste a proxy list at the proxy prompt (one per line, or comma/semicolon separated).

You can also provide them via a `.env` file using `PROXY_LIST` (or `PROXIES`):

```env
# Multiple proxies (one per line, or comma/semicolon separated)
PROXY_LIST=192.0.2.10:8080:username:password
192.0.2.11:8080:username:password
192.0.2.12:8080:username:password
```

**OR** use a single line with commas:

```env
PROXY_LIST=192.0.2.10:8080:username:password,192.0.2.11:8080:username:password
```

> Replace the example values above with your own proxies. Never commit real proxy credentials to version control.

## Alternative: Using the PROXIES Variable

You can also use `PROXIES` instead of `PROXY_LIST`:

```env
PROXIES=192.0.2.10:8080:username:password
192.0.2.11:8080:username:password
```

## Proxy Rotation

- **Round-Robin (Default)**: Proxies are rotated sequentially.
- **Random**: Proxies are selected randomly (configurable in code).

Each request will use the next proxy in rotation.

## Backward Compatibility

A single proxy configuration still works:

```env
PROXY_HOST=localhost
PROXY_PORT=8080
PROXY_USERNAME=user
PROXY_PASSWORD=pass
PROXY_PROTOCOL=http
```

If `PROXY_LIST` or `PROXIES` is set, it takes priority over the single proxy configuration.

## Verification

When you run the cloner with proxies configured, you should see output like:

```
[INFO] Loaded 3 proxy/proxies from PROXY_LIST
[SUCCESS] Initialized 3 proxies with round-robin rotation
[INFO]   [1] http://username:***@192.0.2.10:8080
[INFO]   [2] http://username:***@192.0.2.11:8080
```

This confirms your proxies loaded successfully.
