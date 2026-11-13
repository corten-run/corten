output "address" {
  description = "The address the site's name points at."
  value       = digitalocean_reserved_ip.site.ip_address
}

output "name_servers" {
  description = "The servers the registrar must name for the zone, where its records are kept here."
  value       = var.manage_dns ? ["ns1.digitalocean.com", "ns2.digitalocean.com", "ns3.digitalocean.com"] : []
}
