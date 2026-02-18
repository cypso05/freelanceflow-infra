terraform {
  backend "azurerm" {
    resource_group_name  = "rg-freelanceflow-prod"
    storage_account_name = "stfreelanceflowcore"
    container_name       = "tfstate"
    key                  = "terraform.tfstate"
  }
}
