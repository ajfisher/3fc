module "app" {
  source = "../application"

  env                         = "qa"
  region                      = "ap-southeast-2"
  project_name                = "3fc"
  create_baseline_resources   = true
  create_github_oidc_provider = true
  github_repository           = "ajfisher/3fc"
  github_environment_name     = "qa"
  site_domain                 = "qa.3fc.football"
  ses_from_email              = "noreply@3fc.football"
}
