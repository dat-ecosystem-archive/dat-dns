[![deprecated](http://badges.github.io/stability-badges/dist/deprecated.svg)](github.com/martinheidegger/hyper-dns) See [hyper-dns](github.com/martinheidegger/hyper-dns) for similar functionality. 

More info on active projects and modules at [dat-ecosystem.org](https://dat-ecosystem.org/) <img src="https://i.imgur.com/qZWlO1y.jpg" width="30" height="30" /> 

---

# dat-dns

Issue DNS lookups for Dat archives using HTTPS requests to the target host. Keeps an in-memory cache of recent lookups.

## API

```js
var datDns = require('dat-dns')()

// or, if you have a custom protocol
var datDns = require('dat-dns')({
    recordName: /* name of .well-known file */
    protocolRegex: /* RegExp object for custom protocol */,
    hashRegex: /* RegExp object for custom hash i.e. */,
    txtRegex: /* RegExp object for DNS TXT record of custom protocol */,
})

// example: 
var cabalDns = require('dat-dns')({
    recordName: 'cabal',
    hashRegex: /^[0-9a-f]{64}?$/i,
    protocolRegex: /^cabal:\/\/([0-9a-f]{64})/i,
    txtRegex: /^"?cabalkey=([0-9a-f]{64})"?$/i
})

// resolve a name: pass the hostname by itself
datDns.resolveName('foo.com', function (err, key) { ... })
datDns.resolveName('foo.com').then(key => ...)

// dont use cached 'misses'
datDns.resolveName('foo.com', {ignoreCachedMiss: true})

// dont use the cache at all
datDns.resolveName('foo.com', {ignoreCache: true})

// dont use dns-over-https
datDns.resolveName('foo.com', {noDnsOverHttps: true})

// dont use .well-known/dat
datDns.resolveName('foo.com', {noWellknownDat: true})

// list all entries in the cache
datDns.listCache()

// clear the cache
datDns.flushCache()

// configure the DNS-over-HTTPS host used
var datDns = require('dat-dns')({
  dnsHost: 'dns.google.com',
  dnsPath: '/resolve'
})

// use a persistent fallback cache
// (this is handy for persistent dns data when offline)
var datDns = require('dat-dns')({
  persistentCache: {
    read: async (name, err) => {
      // try lookup
      // if failed, you can throw the original error:
      throw err
    },
    write: async (name, key, ttl) => {
      // write to your cache
    }
  }
})

// emits some events, mainly useful for logging/debugging
datDns.on('resolved', ({method, name, key}) => {...})
datDns.on('failed', ({method, name, err}) => {...})
datDns.on('cache-flushed', () => {...})
```

## Spec

[In detail.](https://www.datprotocol.com/deps/0005-dns/)

**Option 1 (DNS-over-HTTPS).** Create a DNS TXT record witht he following schema:

```
datkey={key}
```

**Option 2 (.well-known/dat).** Place a file at `/.well-known/dat` with the following schema:

```
{dat-url}
TTL={time in seconds}
```

TTL is optional and will default to `3600` (one hour). If set to `0`, the entry is not cached.
