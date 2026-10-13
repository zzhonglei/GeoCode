import { describe, expect, test } from "bun:test"
import { OauthCallbackPage } from "../src/oauth/page"

describe("OauthCallbackPage", () => {
  test("escapes bootstrap options embedded in the inline script", () => {
    const html = OauthCallbackPage.bootstrap({
      provider: `xAI</script><script>alert("provider")</script>`,
      tokenPath: `/token</script><script>alert("path")</script>`,
    })

    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain(`xAI\\u003c/script>\\u003cscript>alert(\\\"provider\\\")\\u003c/script>`)
    expect(html).toContain(`/token\\u003c/script>\\u003cscript>alert(\\\"path\\\")\\u003c/script>`)
  })

  // Guards against a merge restoring OpenCode's name in the pages the user reads after signing in.
  test("GeoCode: the callback pages do not name OpenCode", () => {
    const pages = [
      OauthCallbackPage.success({ provider: "Example" }),
      OauthCallbackPage.error("denied", { provider: "Example" }),
      OauthCallbackPage.bootstrap({ provider: "Example", tokenPath: "/token" }),
    ]
    for (const html of pages) expect(html).not.toContain("OpenCode")
  })
})
