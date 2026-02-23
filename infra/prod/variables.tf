variable "google_oauth_client_id" {
  description = "Google OAuth web client ID used by Cognito social sign-in"
  type        = string
  default     = null
  nullable    = true
}

variable "google_oauth_client_secret" {
  description = "Google OAuth web client secret used by Cognito social sign-in"
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}
