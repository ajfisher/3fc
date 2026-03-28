module "app" {
  source = "../application"

  env                               = "qa"
  region                            = "ap-southeast-2"
  project_name                      = "3fc"
  create_baseline_resources         = true
  create_github_oidc_provider       = true
  manage_shared_ses_domain_identity = true
  github_repository                 = "ajfisher/3fc"
  github_environment_name           = "qa"
  site_domain                       = "qa.3fc.football"
  api_domain                        = "qa-api.3fc.football"
  cognito_domain                    = "auth.qa.3fc.football"
  google_oauth_client_id            = var.google_oauth_client_id
  google_oauth_client_secret        = var.google_oauth_client_secret
  hosted_zone_name                  = "3fc.football"
  ses_from_email                    = "noreply@3fc.football"
  ses_from_domain                   = "3fc.football"
}

removed {
  from = module.app.aws_ses_email_identity.from_address

  lifecycle {
    destroy = false
  }
}
