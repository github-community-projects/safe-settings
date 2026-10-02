module.exports = `<% const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") %>Run on: \`<%= new Date().toISOString() %>\`

* Number of repos considered: \`<%= Object.keys(it.reposProcessed).length %>\`
* Number of repos affected: \`<%= it.reposAffected || 0 %>\`

### Breakdown of changes

<% if (!it.checkRunDetails || it.checkRunDetails.length === 0) { %>
No changes to apply.
<% } else { %>
<%~ it.checkRunDetails %>
<% } %>

### Breakdown of errors

<% if (Object.keys(it.errors).length === 0) { %>
\`None\`
<% } else { %>
<details>
<summary>:warning: Errors by repo — <%= Object.keys(it.errors).length %> repo(s) affected</summary>

<%~ Object.keys(it.errors).map(repo => "**" + esc(repo) + "**:\\n" + it.errors[repo].map(err => "* " + esc(err.msg)).join("\\n")).join("\\n\\n") %>

</details>
<% } %>

### Informational messages

<% if (!it.infos || Object.keys(it.infos).length === 0) { %>
\`None\`
<% } else { %>
<details>
<summary>:information_source: Info — <%= Object.keys(it.infos).length %> repo(s)</summary>

<%~ Object.keys(it.infos).map(repo => "**" + esc(repo) + "**:\\n" + it.infos[repo].map(msg => "* ℹ️ " + esc(msg)).join("\\n")).join("\\n\\n") %>

</details>
<% } %>`
