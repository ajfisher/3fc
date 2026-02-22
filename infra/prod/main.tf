module "app" {
  source = "../application"

  env                       = "prod"
  region                    = "ap-southeast-2"
  project_name              = "3fc"
  create_baseline_resources = true
  site_domain               = "app.3fc.football"
  ses_from_email            = "noreply@3fc.football"
}
