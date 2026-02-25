# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e3]:
    - generic [ref=e4]:
      - heading "Semibot" [level=1] [ref=e5]
      - paragraph [ref=e6]: AI Agent 编排平台
    - generic [ref=e8]:
      - heading "登录账户" [level=2] [ref=e9]
      - generic [ref=e10]:
        - generic [ref=e11]:
          - generic [ref=e12]: 邮箱
          - generic [ref=e14]:
            - img [ref=e16]
            - textbox "邮箱" [ref=e19]:
              - /placeholder: 请输入邮箱
        - generic [ref=e20]:
          - generic [ref=e21]: 密码
          - generic [ref=e22]:
            - generic [ref=e24]:
              - img [ref=e26]
              - textbox "密码" [ref=e29]:
                - /placeholder: 请输入密码
            - button "显示密码" [ref=e30] [cursor=pointer]:
              - img [ref=e31]
        - generic [ref=e34]:
          - generic [ref=e35] [cursor=pointer]:
            - checkbox "记住我" [ref=e36]
            - generic [ref=e37]: 记住我
          - link "忘记密码？" [ref=e38] [cursor=pointer]:
            - /url: /forgot-password
        - button "登录" [ref=e39] [cursor=pointer]
      - paragraph [ref=e40]:
        - text: 还没有账户？
        - link "立即注册" [ref=e41] [cursor=pointer]:
          - /url: /register
  - alert [ref=e42]
```