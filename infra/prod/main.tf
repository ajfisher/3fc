module "app" {
  source = "../application"

  env    = "prod"
  region = "ap-southeast-2"
  # ...names, domains later, etc
}
