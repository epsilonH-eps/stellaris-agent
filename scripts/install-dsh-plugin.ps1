#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
& (Join-Path $root 'dsh-stellaris-bridge\install.ps1')
