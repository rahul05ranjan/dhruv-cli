#!/bin/bash

# GitHub Actions Workflow Validation Script
# Validates all enterprise-level features are properly configured

set -e

echo "🔍 GitHub Actions Enterprise-Level Validation"
echo "============================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
TOTAL_CHECKS=0
PASSED_CHECKS=0
FAILED_CHECKS=0

check_result() {
    TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✅ $2${NC}"
        PASSED_CHECKS=$((PASSED_CHECKS + 1))
    else
        echo -e "${RED}❌ $2${NC}"
        FAILED_CHECKS=$((FAILED_CHECKS + 1))
    fi
}

echo -e "${BLUE}📋 Core Workflow Files${NC}"
echo "-------------------------"

# Check if main workflows exist
workflows=(
    ".github/workflows/ci.yml"
    ".github/workflows/security.yml"
    ".github/workflows/release.yml"
    ".github/workflows/deploy.yml"
    ".github/workflows/monitoring.yml"
    ".github/workflows/dependabot-auto-merge.yml"
)

for workflow in "${workflows[@]}"; do
    if [ -f "$workflow" ]; then
        check_result 0 "Workflow exists: $(basename "$workflow")"
    else
        check_result 1 "Missing workflow: $(basename "$workflow")"
    fi
done

echo ""
echo -e "${BLUE}🔒 Security Features${NC}"
echo "--------------------"

# Check for security hardening
if grep -q "step-security/harden-runner" .github/workflows/ci.yml; then
    check_result 0 "Step Security hardening enabled in CI"
else
    check_result 1 "Step Security hardening missing in CI"
fi

# Check for security scanning
if grep -q "github/codeql-action" .github/workflows/security.yml; then
    check_result 0 "CodeQL security scanning configured"
else
    check_result 1 "CodeQL security scanning missing"
fi

# Check for dependency scanning
if grep -q "anchore/scan-action" .github/workflows/security.yml; then
    check_result 0 "Container/dependency scanning configured"
else
    check_result 1 "Container/dependency scanning missing"
fi

echo ""
echo -e "${BLUE}🧪 Testing & Quality${NC}"
echo "---------------------"

# Check for multi-OS testing
if grep -q "ubuntu-latest\|windows-latest\|macos-latest" .github/workflows/ci.yml; then
    check_result 0 "Multi-OS testing configured"
else
    check_result 1 "Multi-OS testing missing"
fi

# Check for Node.js matrix testing
if grep -q "node-version.*18\|node-version.*20" .github/workflows/ci.yml; then
    check_result 0 "Node.js version matrix testing"
else
    check_result 1 "Node.js version matrix testing missing"
fi

# Check for test coverage
if grep -q "coverage" .github/workflows/ci.yml; then
    check_result 0 "Test coverage reporting configured"
else
    check_result 1 "Test coverage reporting missing"
fi

echo ""
echo -e "${BLUE}🚀 Deployment & Release${NC}"
echo "---------------------------"

# Check for automated releases
if [ -f ".github/workflows/release.yml" ]; then
    if grep -q "semantic-release\|release" .github/workflows/release.yml; then
        check_result 0 "Automated release process configured"
    else
        check_result 1 "Automated release process incomplete"
    fi
fi

# Check for deployment environments
if grep -q "environment:" .github/workflows/deploy.yml; then
    check_result 0 "Deployment environments configured"
else
    check_result 1 "Deployment environments missing"
fi

# Check for deployment protection
if grep -q "timeout-minutes" .github/workflows/deploy.yml; then
    check_result 0 "Deployment timeouts configured"
else
    check_result 1 "Deployment timeouts missing"
fi

echo ""
echo -e "${BLUE}📊 Monitoring & Alerting${NC}"
echo "-------------------------"

# Check for monitoring workflows
if [ -f ".github/workflows/monitoring.yml" ]; then
    if grep -q "schedule:" .github/workflows/monitoring.yml; then
        check_result 0 "Scheduled monitoring configured"
    else
        check_result 1 "Scheduled monitoring missing"
    fi
fi

# Check for failure notifications
if grep -q "create-failure-issue\|notification" .github/workflows/monitoring.yml; then
    check_result 0 "Failure notification system configured"
else
    check_result 1 "Failure notification system missing"
fi

echo ""
echo -e "${BLUE}🤖 Automation Features${NC}"
echo "------------------------"

# Check for Dependabot
if [ -f ".github/dependabot.yml" ]; then
    check_result 0 "Dependabot configuration exists"
else
    check_result 1 "Dependabot configuration missing"
fi

# Check for auto-assignment
if [ -f ".github/workflows/auto-assign.yml" ]; then
    check_result 0 "Auto-assignment workflow exists"
else
    check_result 1 "Auto-assignment workflow missing"
fi

# Check for stale issue management
if [ -f ".github/workflows/stale.yml" ]; then
    check_result 0 "Stale issue management configured"
else
    check_result 1 "Stale issue management missing"
fi

echo ""
echo -e "${BLUE}📝 Templates & Documentation${NC}"
echo "--------------------------------"

# Check for issue templates
templates=(
    ".github/ISSUE_TEMPLATE/bug_report.md"
    ".github/ISSUE_TEMPLATE/feature_request.md"
    ".github/ISSUE_TEMPLATE/security_vulnerability.md"
)

for template in "${templates[@]}"; do
    if [ -f "$template" ]; then
        check_result 0 "Issue template exists: $(basename "$template" .md)"
    else
        check_result 1 "Missing issue template: $(basename "$template" .md)"
    fi
done

# Check for PR template
if [ -f ".github/pull_request_template.md" ]; then
    check_result 0 "Pull request template exists"
else
    check_result 1 "Pull request template missing"
fi

echo ""
echo -e "${BLUE}⚙️ Configuration Validation${NC}"
echo "----------------------------"

# Validate package.json scripts
required_scripts=("test:ci" "build" "lint" "docs")
for script in "${required_scripts[@]}"; do
    if grep -q "\"$script\":" package.json; then
        check_result 0 "Package script exists: $script"
    else
        check_result 1 "Missing package script: $script"
    fi
done

# Check for proper permissions in workflows
if grep -q "permissions:" .github/workflows/ci.yml; then
    check_result 0 "Workflow permissions configured"
else
    check_result 1 "Workflow permissions missing"
fi

echo ""
echo -e "${BLUE}🔐 Security Configuration${NC}"
echo "---------------------------"

# Check for security policy
if [ -f "SECURITY.md" ]; then
    check_result 0 "Security policy document exists"
else
    check_result 1 "Security policy document missing"
fi

# Check for code of conduct
if [ -f "CODE_OF_CONDUCT.md" ]; then
    check_result 0 "Code of conduct exists"
else
    check_result 1 "Code of conduct missing"
fi

# Check for contributing guidelines
if [ -f "CONTRIBUTING.md" ]; then
    check_result 0 "Contributing guidelines exist"
else
    check_result 1 "Contributing guidelines missing"
fi

echo ""
echo "============================================="
echo -e "${BLUE}📊 Validation Summary${NC}"
echo "============================================="
echo -e "Total Checks: ${YELLOW}$TOTAL_CHECKS${NC}"
echo -e "Passed: ${GREEN}$PASSED_CHECKS${NC}"
echo -e "Failed: ${RED}$FAILED_CHECKS${NC}"

if [ $FAILED_CHECKS -eq 0 ]; then
    echo ""
    echo -e "${GREEN}🎉 EXCELLENT! Your GitHub Actions setup meets enterprise-level standards!${NC}"
    echo -e "${GREEN}All workflows, security features, and automation are properly configured.${NC}"
    exit 0
elif [ $FAILED_CHECKS -le 3 ]; then
    echo ""
    echo -e "${YELLOW}⚠️  GOOD! Your setup is mostly enterprise-ready with minor improvements needed.${NC}"
    exit 1
else
    echo ""
    echo -e "${RED}❌ NEEDS WORK! Several enterprise-level features are missing or misconfigured.${NC}"
    exit 2
fi
