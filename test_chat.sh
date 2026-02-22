#!/bin/bash
TOKEN='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJlYzc1OWMyYS0xOGMzLTQxZWEtYWNjMi0zMzcxMjg3ODllN2YiLCJvcmdJZCI6ImNiMTc3NDhhLTU4MjEtNGIxMC1iYjZhLTIyNzRmNzEyNzNkZCIsInJvbGUiOiJvd25lciIsInBlcm1pc3Npb25zIjpbIioiXSwidHlwZSI6ImFjY2VzcyIsImlhdCI6MTc3MTQ1ODEyMSwiZXhwIjoxNzcxNTQ0NTIxfQ.UryFF-Pkz5h2C4rxxvAhN8ZpfGNbrF9Ed_zgSSwGgQw'

curl -s -N -X POST 'http://localhost:3000/api/v1/chat/start' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"agentId":"00000000-0000-0000-0000-000000000001","message":"搜索最新的AI行业动态并总结，生成pdf报告。同时把重要事件整理成表格，存储成xlsx"}'
