# rDNS NS

This is a simple DNS server for providing reverse DNS for dynamic/SLAAC IPv6 addresses. It was created to provide reverse DNS for larger dynamic allocations (in my case, `/56`'s routed to my house and for my VPN) as other reverse DNS servers (e.g. [AllKnowingDNS](https://all-knowing-dns.zekjur.net/)) only work for prefix lengths divisible by 16.

# Configuration

Each prefix that the DNS server should handle should be configured in `config.json`.

```json
{
	"prefix": "2001:db8:1234:5600::/56",
	"recordFormat": "lon-{addr}.rdns.isp.example",
	"static": [
		{
			"address": "2001:db8:1234:5600::1",
			"record": "lon-router01.isp.example"
		}
	]
}
```

The record format **must** be unique for each prefix for the `AAAA` lookups to work properly. Similarly, the prefixes must be unique and not overlapping.

The `listenOn` and `listenOnV6` configuration options are also required.

You should also configure the `thisNS` setting. Set this to the delegated nameserver record (see the DNS Delegation section below). These nameservers will be returned whenever an `NS` request is received for a prefix or root reverse DNS record defined in the config (e.g. `9.5.4.3.2.1.8.b.d.0.1.0.0.2.ip6.arpa` and `rdns.isp.example.com` from the above example). If the prefix length is not divisible by 4, the NS will be returned for the subdomain of the `ip6.arpa` zone (e.g. `2001:db8:1234:5900::/57` will return NS on `x.9.5.4.3.2.1.8.b.d.0.1.0.0.2.ip6.arpa` where `x` is `[0-9a-f]`).

Optionally, the `idServer` setting can be configured. This will be returned when a `TXT CH` request for `id.server` is received.

To allow rDNS NS to bind to port 53, you will need to run the following command: `sudo setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))`.

# DNS Delegation

You will need to delegate the DNS zones that rDNS NS should handle.

```zone
6.5.4.3.2.1.8.b.d.0.1.0.0.2.ip6.arpa. IN NS rdns-ns.isp.example.
```

```zone
rdns.isp.example. IN NS rdns-ns.isp.example.
```