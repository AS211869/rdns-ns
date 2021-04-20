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

A script (`iptables.sh`) has been included to configure the neccessary iptables rules. Modify the command to include the rDNS NS IP addresses before using.

# DNS Delegation

You will need to delegate the DNS zones that rDNS NS should handle.

```zone
6.5.4.3.2.1.8.b.d.0.1.0.0.2.ip6.arpa. IN NS rdns-ns.isp.example.
```

```zone
rdns.isp.example. IN NS rdns-ns.isp.example.
```