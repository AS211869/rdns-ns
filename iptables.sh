#!/bin/bash

# Replace IPV4_ADDRESS_HERE and IPV6_ADDRESS_HERE with the IP addresses the DNS server should run on

iptables -t nat -A PREROUTING -p udp -d IPV4_ADDRESS_HERE --dport 53 -j REDIRECT --to 41514
iptables -t nat -A PREROUTING -p tcp -d IPV4_ADDRESS_HERE --dport 53 -j REDIRECT --to 41514
ip6tables -t nat -A PREROUTING -p udp -d IPV6_ADDRESS_HERE --dport 53 -j REDIRECT --to 41514
ip6tables -t nat -A PREROUTING -p tcp -d IPV6_ADDRESS_HERE --dport 53 -j REDIRECT --to 41514