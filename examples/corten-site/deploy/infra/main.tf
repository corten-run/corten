# The machine that serves the site, the address it is reached at and the name that points there
# (../README.md). The machine sets itself up as it first starts, from the files beside this
# directory, so a change to any of them makes a new machine and removes the old one.

locals {
  zone    = coalesce(var.zone, var.domain)
  record  = var.domain == local.zone ? "@" : trimsuffix(var.domain, ".${local.zone}")
  machine = coalesce(var.machine, "a DigitalOcean droplet, ${var.size} in ${var.region}")

  # What the machine is handed as it starts (cloud-init). Files go over as base64, so nothing
  # in them is read as YAML.
  files = {
    "/root/deploy/provision.sh"                    = file("${path.module}/../provision.sh")
    "/root/deploy/nginx.conf"                      = file("${path.module}/../nginx.conf")
    "/root/deploy/corten-site.service"             = file("${path.module}/../corten-site.service")
    "/root/deploy/boot.sh"                         = file("${path.module}/boot.sh")
    "/root/deploy/deploy.pub"                      = "${trimspace(var.deploy_key)}\n"
    "/etc/systemd/system/corten-site-boot.service" = file("${path.module}/corten-site-boot.service")
    # Read by boot.sh as shell. Each value is checked to hold no quote (variables.tf), the size
    # and region in the third among them.
    "/root/deploy/site.conf" = join("", [
      "domain='${var.domain}'\n",
      "email='${var.email}'\n",
      "machine='${local.machine}'\n",
    ])
  }

  cloud_config = {
    # No password signs in over SSH: the deploy key, the keys in `admin_keys`, or the console.
    ssh_pwauth = false
    # The host key is the same on every machine made here, so the Site workflow, which is told
    # that key once, knows a new machine as the host it already trusts.
    ssh_keys = {
      ed25519_private = "${trimspace(var.host_key)}\n"
      ed25519_public  = trimspace(var.host_key_public)
    }
    write_files = [
      for path, content in local.files : {
        path        = path
        encoding    = "b64"
        content     = base64encode(content)
        permissions = startswith(path, "/etc/systemd/") ? "0644" : "0600"
      }
    ]
    runcmd = [
      ["systemctl", "daemon-reload"],
      ["systemctl", "enable", "--now", "--no-block", "corten-site-boot.service"],
    ]
  }
}

resource "digitalocean_tag" "site" {
  name = "corten-site"
}

# The address stays when the machine is replaced, so the name never has to move. It names its
# machine itself, so a replacement changes it in place, once the new machine is made: a separate
# assignment is replaced instead, and its old half is removed before the new machine exists.
resource "digitalocean_reserved_ip" "site" {
  region     = var.region
  droplet_id = digitalocean_droplet.site.id
}

resource "digitalocean_droplet" "site" {
  name      = "corten-site"
  image     = "ubuntu-24-04-x64"
  size      = var.size
  region    = var.region
  ssh_keys  = var.admin_keys
  tags      = [digitalocean_tag.site.id]
  user_data = "#cloud-config\n${yamlencode(local.cloud_config)}"

  # The new machine is made before the address moves to it, and the old one goes after that: a
  # machine that cannot be made leaves the old one serving. The site is down from the move
  # until the new machine has its certificate and its first release.
  lifecycle {
    create_before_destroy = true
  }
}

# The machine's own firewall (ufw, ../provision.sh) allows the same three ports. This one is by
# tag, so it holds for a machine before the machine has set its own.
resource "digitalocean_firewall" "site" {
  name = "corten-site"
  tags = [digitalocean_tag.site.id]

  dynamic "inbound_rule" {
    for_each = ["22", "80", "443"]
    content {
      protocol         = "tcp"
      port_range       = inbound_rule.value
      source_addresses = ["0.0.0.0/0", "::/0"]
    }
  }

  dynamic "outbound_rule" {
    for_each = ["tcp", "udp"]
    content {
      protocol              = outbound_rule.value
      port_range            = "1-65535"
      destination_addresses = ["0.0.0.0/0", "::/0"]
    }
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

# The zone's records are served by DigitalOcean once the registrar names its servers
# (ns1, ns2 and ns3.digitalocean.com) as the zone's own.
resource "digitalocean_domain" "site" {
  count = var.manage_dns ? 1 : 0
  name  = local.zone
}

resource "digitalocean_record" "site" {
  count  = var.manage_dns ? 1 : 0
  domain = digitalocean_domain.site[0].id
  type   = "A"
  name   = local.record
  value  = digitalocean_reserved_ip.site.ip_address
  ttl    = 300

  lifecycle {
    precondition {
      condition     = var.domain == local.zone || endswith(var.domain, ".${local.zone}")
      error_message = "The site's name is not in the zone given: its record would be written under another name."
    }
  }
}

resource "digitalocean_record" "spf" {
  count  = var.manage_dns && var.refuse_mail ? 1 : 0
  domain = digitalocean_domain.site[0].id
  type   = "TXT"
  name   = "@"
  value  = "v=spf1 -all"
  ttl    = 3600
}

resource "digitalocean_record" "dmarc" {
  count  = var.manage_dns && var.refuse_mail ? 1 : 0
  domain = digitalocean_domain.site[0].id
  type   = "TXT"
  name   = "_dmarc"
  value  = "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s"
  ttl    = 3600
}
