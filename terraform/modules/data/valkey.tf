resource "aws_security_group" "valkey" {
  name        = "${var.name}-valkey"
  description = "Valkey ingress from ECS tasks only"
  vpc_id      = var.vpc_id
}

resource "aws_elasticache_subnet_group" "valkey" {
  name       = "${var.name}-valkey"
  subnet_ids = var.private_subnet_ids
}

# ElastiCache's CreateCacheCluster API does not accept Valkey — single-node
# Valkey still has to go through a replication group with one node and zero
# replicas. Confusingly named but it's the only supported path.
resource "aws_elasticache_replication_group" "valkey" {
  replication_group_id = "${var.name}-valkey"
  description          = "${var.name} Valkey single-node"

  engine         = "valkey"
  engine_version = "9.0"
  node_type      = "cache.t4g.small"
  port           = 6379

  num_node_groups            = 1
  replicas_per_node_group    = 0
  automatic_failover_enabled = false
  multi_az_enabled           = false

  parameter_group_name = "default.valkey9"
  subnet_group_name    = aws_elasticache_subnet_group.valkey.name
  security_group_ids   = [aws_security_group.valkey.id]

  transit_encryption_enabled = false
  at_rest_encryption_enabled = true

  snapshot_retention_limit = 0
  apply_immediately        = true
}
