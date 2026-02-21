module "app" {
  source = "../application"

  env    = "qa"
  region = "ap-southeast-2"
  # ...names, domains later, etc
}
