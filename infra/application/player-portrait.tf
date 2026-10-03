# Processed portraits are private; requests are authorised by the API, never S3 URLs.
resource "aws_s3_bucket" "player_portraits" {
  count         = var.create_baseline_resources ? 1 : 0
  bucket        = "${local.name_prefix}-portraits-${data.aws_caller_identity.current.account_id}"
  force_destroy = false
  tags          = local.app_tags
}
resource "aws_s3_bucket_public_access_block" "player_portraits" {
  count                   = var.create_baseline_resources ? 1 : 0
  bucket                  = aws_s3_bucket.player_portraits[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "player_portraits" {
  count  = var.create_baseline_resources ? 1 : 0
  bucket = aws_s3_bucket.player_portraits[0].id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "player_portraits" {
  count  = var.create_baseline_resources ? 1 : 0
  bucket = aws_s3_bucket.player_portraits[0].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_policy" "player_portraits" {
  count  = var.create_baseline_resources ? 1 : 0
  bucket = aws_s3_bucket.player_portraits[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Sid       = "RequireTLS", Effect = "Deny", Principal = "*", Action = "s3:*",
    Resource  = [aws_s3_bucket.player_portraits[0].arn, "${aws_s3_bucket.player_portraits[0].arn}/*"],
    Condition = { Bool = { "aws:SecureTransport" = "false" } }
  }] })
}
resource "aws_iam_role_policy" "player_portrait_core" {
  count = var.create_baseline_resources ? 1 : 0
  name  = "${local.name_prefix}-player-portrait-core"
  role  = aws_iam_role.lambda_exec[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect   = "Allow", Action = ["s3:GetObject", "s3:PutObject"],
    Resource = "${aws_s3_bucket.player_portraits[0].arn}/portraits/*"
  }] })
}
resource "aws_iam_role_policy" "player_portrait_cleanup" {
  count = var.create_baseline_resources ? 1 : 0
  name  = "${local.name_prefix}-player-portrait-cleanup"
  role  = aws_iam_role.player_history_worker[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect   = "Allow", Action = ["s3:DeleteObject"],
    Resource = "${aws_s3_bucket.player_portraits[0].arn}/portraits/*"
  }] })
}
output "player_portrait_bucket_name" {
  value = var.create_baseline_resources ? aws_s3_bucket.player_portraits[0].id : null
}
