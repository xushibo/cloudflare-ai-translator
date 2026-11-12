# Security

Do not post API tokens, credentials, source text, or private translations in public issues.
Report a suspected vulnerability through the repository's Security → Report a vulnerability
when available; otherwise contact the maintainer privately through their GitHub profile.

The API is public by default, has permissive CORS, and does not authenticate clients.
The API path is not a password. Apply your own access controls if required.
The daily Neurons threshold is a delayed analytics soft cap, not a strict billing limit.
The analytics token must only have Account Analytics Read on the deployment account.
Rotate any credential accidentally included in a commit; removing a file alone does not
remove it from Git history.
