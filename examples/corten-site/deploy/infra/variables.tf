variable "domain" {
  description = "The name the site is served at, such as example.com or www.example.com."
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.domain))
    error_message = "Give the name alone, in lower case: no scheme, path or port."
  }
}

variable "zone" {
  description = "The DNS zone the name is in, where that is not the name itself (example.com for www.example.com)."
  type        = string
  default     = null
}

variable "manage_dns" {
  description = "Whether the zone's records are kept here. Set false where its DNS stays elsewhere, and point an A record at the address this gives."
  type        = bool
  default     = true
}

variable "refuse_mail" {
  description = "Whether the zone says it sends no mail (SPF and DMARC records that refuse all of it). Only for a zone that has no mail."
  type        = bool
  default     = false
}

variable "email" {
  description = "The address Let's Encrypt writes to when a certificate is about to lapse."
  type        = string
  sensitive   = true
  validation {
    condition     = can(regex("^[^@\\s'\"\\\\]+@[^@\\s'\"\\\\]+$", var.email))
    error_message = "Give one email address, without quotes."
  }
}

variable "region" {
  description = "The DigitalOcean region the machine is in."
  type        = string
  default     = "sfo3"
}

variable "size" {
  description = "The droplet's size. The default is the smallest there is."
  type        = string
  default     = "s-1vcpu-512mb-10gb"
}

variable "machine" {
  description = "What the page adds after the machine's own count of itself, such as the size's name and price. Without it, the size and region."
  type        = string
  default     = null
  validation {
    condition     = var.machine == null || can(regex("^[^'\"\\\\\\n]*$", var.machine))
    error_message = "Say what the machine is without quotes or backslashes, on one line."
  }
}

variable "deploy_key" {
  description = "The public half of the key the Site workflow ships releases with."
  type        = string
  validation {
    condition     = can(regex("^ssh-ed25519 [A-Za-z0-9+/=]+( [^\\n]*)?$", trimspace(var.deploy_key)))
    error_message = "Give one ed25519 public key, as ssh-keygen writes it."
  }
}

variable "host_key" {
  description = "The private half of the machine's SSH host key. Given to each machine made here, so a machine that replaces another is known to the Site workflow as the same host."
  type        = string
  sensitive   = true
}

variable "host_key_public" {
  description = "The public half of the machine's SSH host key."
  type        = string
  validation {
    condition     = can(regex("^ssh-ed25519 [A-Za-z0-9+/=]+( [^\\n]*)?$", trimspace(var.host_key_public)))
    error_message = "Give one ed25519 public key, as ssh-keygen writes it."
  }
}

variable "admin_keys" {
  description = "Fingerprints of the account's SSH keys that may sign in as root. With none, root is reached through the control panel's console alone."
  type        = list(string)
  default     = []
}
