"""Unit tests for output_scanner.py — secret/PII detection and redaction."""

import pytest

from output_scanner import ScanResult, scan_tool_output

# An AWS access key id, a colon and a secret access key that holds no slash.
_KEY_PAIR = "AKIAIOSFODNN7EXAMPLE:" + "A1b2" * 10

# A password with letters and digits, as somebody may leave it inside the
# brackets of a placeholder. Assembled, like the token below, so that this file
# holds no credential-shaped literal.
_LETTERS_AND_DIGITS = "Passw0rd" + "123"

# A GitHub App installation token of the stateless format, ghs_<app id>_<JWT>:
# three base64url parts, which may hold "-" and "_", joined by dots. Assembled
# here so that this file holds no token-shaped literal.
_APP_TOKEN = (
    "gh" + "s_123456_" + ".".join(["eyJ" + "hbGciOi" * 5, "eyJ" + "pYXQi-_" * 40, "s1G-n_" * 30])
)


class TestScanResultDefaults:
    def test_clean_result(self):
        r = ScanResult(has_sensitive_content=False, redacted_content="hello")
        assert r.findings == []
        assert r.duration_ms == 0.0


class TestScanToolOutput:
    # ---- AWS keys ----

    def test_detects_aws_access_key(self):
        content = "key=AKIAIOSFODNN7EXAMPLE"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "AWS_KEY detected" in result.findings
        assert "AKIAIOSFODNN7EXAMPLE" not in result.redacted_content
        assert "[REDACTED-AWS_KEY]" in result.redacted_content

    def test_detects_temporary_aws_access_key(self):
        # Key ids of temporary credentials (STS), the kind the agent itself
        # runs with, start with ASIA.
        content = "AWS_ACCESS_KEY_ID=ASIAIOSFODNN7EXAMPLE"
        result = scan_tool_output(content)
        assert result.findings == ["AWS_KEY detected"]
        assert result.redacted_content == "AWS_ACCESS_KEY_ID=[REDACTED-AWS_KEY]"

    def test_detects_aws_secret_key(self):
        content = "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "AWS_SECRET detected" in result.findings
        assert "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" not in result.redacted_content

    def test_detects_aws_secret_key_case_insensitive(self):
        content = 'SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "AWS_SECRET detected" in result.findings

    def test_detects_aws_key_pair_in_a_url(self):
        # s3a://<key id>:<secret>@bucket. Nearly half of all secret keys hold a
        # "/", which the connection-string pattern does not accept in a password;
        # a URL whose user is a key id is replaced as a whole all the same.
        content = "s3a://AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY@bucket/path"
        result = scan_tool_output(content)
        assert result.findings == ["AWS_KEY detected", "CONNECTION_STRING detected"]
        assert result.redacted_content == "[REDACTED-CONNECTION_STRING]"

    @pytest.mark.parametrize(
        "url",
        [
            pytest.param(
                f"mongodb+srv://{_KEY_PAIR}@cluster0.example.net/app?authMechanism=MONGODB-AWS"
                "&authMechanismProperties=AWS_SESSION_TOKEN:" + "T0ken" * 8,
                id="session token in the query",
            ),
            pytest.param(
                f"https://{_KEY_PAIR}@files.example.com/get?password=Pa55w0rdQuery",
                id="password in the query",
            ),
            pytest.param(
                f"postgres://{_KEY_PAIR}-TailOfPassword@db.internal/app",
                id="password longer than a secret key",
            ),
            pytest.param(
                "smtp://AKIAIOSFODNN7EXAMPLE:"
                + "aB3/" * 11
                + "@email-smtp.us-east-1.amazonaws.com:587",
                id="SES SMTP password: 44 characters, with slashes",
            ),
            pytest.param(
                f"https://{_KEY_PAIR}:" + "aB3/" * 150 + "@s3.amazonaws.com",
                id="session token after the secret key (MC_HOST of the MinIO client)",
            ),
        ],
    )
    def test_url_with_an_aws_key_id_as_user_is_replaced_as_a_whole(self, url):
        # AWS_KEY runs first and leaves scheme://[REDACTED-AWS_KEY]...@host, which
        # is no user:password@host any more. The rest of the URL (the rest of a
        # password, a secret in the query) must not stay readable for that.
        assert scan_tool_output(url).redacted_content == "[REDACTED-CONNECTION_STRING]"

    def test_longer_run_after_an_aws_key_id_is_not_its_secret(self):
        # A secret access key has exactly 40 characters.
        content = "AKIAIOSFODNN7EXAMPLE:" + "a" * 41
        result = scan_tool_output(content)
        assert result.redacted_content == "[REDACTED-AWS_KEY]:" + "a" * 41

    # ---- GitHub tokens ----

    def test_detects_ghp_token(self):
        content = "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "GITHUB_TOKEN detected" in result.findings
        assert "ghp_" not in result.redacted_content
        assert "[REDACTED-GITHUB_TOKEN]" in result.redacted_content

    def test_detects_gho_token(self):
        content = "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "GITHUB_TOKEN detected" in result.findings

    def test_detects_ghs_token(self):
        content = "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "GITHUB_TOKEN detected" in result.findings

    def test_detects_github_fine_grained_pat(self):
        content = "github_pat_ABCDEFGHIJKLMNOPQRSTUV_12345678901234567890"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "GITHUB_PAT detected" in result.findings
        assert "[REDACTED-GITHUB_PAT]" in result.redacted_content

    def test_detects_token_longer_than_36_chars(self):
        # Token lengths vary across generations; the pattern must not be
        # anchored to exactly 36 chars.
        content = "token: ghs_" + "A" * 48
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "GITHUB_TOKEN detected" in result.findings
        assert "ghs_" not in result.redacted_content

    @pytest.mark.parametrize(
        ("content", "redacted"),
        [
            pytest.param(
                f"GITHUB_TOKEN={_APP_TOKEN}",
                "GITHUB_TOKEN=[REDACTED-GITHUB_APP_TOKEN]",
                id="an assignment",
            ),
            pytest.param(_APP_TOKEN, "[REDACTED-GITHUB_APP_TOKEN]", id="the bare token"),
            pytest.param(
                f'{{"token": "{_APP_TOKEN}", "expires_at": "2026-11-17T12:00:00Z"}}',
                '{"token": "[REDACTED-GITHUB_APP_TOKEN]", "expires_at": "2026-11-17T12:00:00Z"}',
                id="a JSON value",
            ),
            pytest.param(
                f"Authorization: token {_APP_TOKEN}",
                "Authorization: token [REDACTED-GITHUB_APP_TOKEN]",
                id="an Authorization: token header",
            ),
        ],
    )
    def test_detects_stateless_app_installation_token(self, content, redacted):
        # Every new installation token has this format since 2026. The pattern
        # for the older ones wants 36 letters or digits after "ghs_" and stops
        # at the underscore after the app id.
        result = scan_tool_output(content)
        assert result.findings == ["GITHUB_APP_TOKEN detected"]
        assert result.redacted_content == redacted

    @pytest.mark.parametrize(
        ("content", "redacted", "finding"),
        [
            pytest.param(
                f"Authorization: Bearer {_APP_TOKEN}",
                "Authorization: [REDACTED-BEARER_TOKEN]",
                "BEARER_TOKEN detected",
                id="after Bearer",
            ),
            pytest.param(
                f"https://x-access-token:{_APP_TOKEN}:x-oauth-basic@github.com/o/r.git?t=QuerySecret7",
                "[REDACTED-CONNECTION_STRING]",
                "CONNECTION_STRING detected",
                id="in a URL that is replaced as a whole",
            ),
        ],
    )
    def test_stateless_app_token_leaves_the_other_patterns_their_match(
        self, content, redacted, finding
    ):
        # The pattern runs last: what another pattern replaced together with
        # such a token before it existed is replaced as before.
        result = scan_tool_output(content)
        assert result.findings == [finding]
        assert result.redacted_content == redacted

    @pytest.mark.parametrize(
        "content",
        ["ghs_123456", "see ghs_2024_hazard_statements_and_pictograms.v2.csv"],
    )
    def test_ghs_prefix_and_digits_alone_are_not_a_token(self, content):
        result = scan_tool_output(content)
        assert result.has_sensitive_content is False
        assert result.redacted_content == content

    def test_detects_token_in_remote_url(self):
        # `git remote -v` style output with x-access-token credentials.
        content = "origin  https://x-access-token:ghs_secret123@github.com/owner/repo.git (push)"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "GITHUB_URL_TOKEN detected" in result.findings
        assert "ghs_secret123" not in result.redacted_content

    def test_detects_long_app_token_in_remote_url(self):
        # GitHub App installation tokens (ghs_<app id>_<JWT>) are about 520
        # characters since 2026 and vary in length: a token has no length limit.
        token = "ghs_123456_" + ".".join(["eyJ" + "a" * 200] * 3)
        result = scan_tool_output(f"x-access-token:{token}@github.com/owner/repo.git")
        assert result.redacted_content == "[REDACTED-GITHUB_URL_TOKEN]github.com/owner/repo.git"

    def test_text_with_a_colon_is_a_remote_url_token_up_to_512_characters(self):
        # A token holds no ":". Other text before the "@" is still replaced, but
        # only up to 512 characters: unlimited, a text that repeats
        # "x-access-token:" is scanned from each one to the end (quadratic).
        at_the_limit = "x-access-token:a:" + "a" * 510 + "@"
        assert scan_tool_output(at_the_limit).redacted_content == "[REDACTED-GITHUB_URL_TOKEN]"
        over_the_limit = "x-access-token:a:" + "a" * 511 + "@"
        assert scan_tool_output(over_the_limit).redacted_content == over_the_limit

    # ---- Slack tokens ----

    def test_detects_slack_token(self):
        # Assembled here so that this file holds no token-shaped literal.
        token = "xo" + "xb-" + "1234567890-abcdefghijklmno"
        result = scan_tool_output(f"SLACK_BOT_TOKEN={token}")
        assert result.findings == ["SLACK_TOKEN detected"]
        assert result.redacted_content == "SLACK_BOT_TOKEN=[REDACTED-SLACK_TOKEN]"

    # ---- Private keys ----

    def test_detects_rsa_private_key(self):
        content = (
            "-----BEGIN RSA PRIVATE KEY-----\n"
            "MIIEowIBAAKCAQEA0Z3VS5JJcds3xf...\n"
            "-----END RSA PRIVATE KEY-----"
        )
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "PRIVATE_KEY detected" in result.findings
        assert "BEGIN RSA PRIVATE KEY" not in result.redacted_content
        assert "[REDACTED-PRIVATE_KEY]" in result.redacted_content

    def test_detects_generic_private_key(self):
        content = (
            "-----BEGIN PRIVATE KEY-----\n"
            "MIIEvQIBADANBgkqhkiG9w0BAQEFA...\n"
            "-----END PRIVATE KEY-----"
        )
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "PRIVATE_KEY detected" in result.findings

    def test_detects_ec_private_key(self):
        content = "-----BEGIN EC PRIVATE KEY-----\nMIGkAgEBBDDx...\n-----END EC PRIVATE KEY-----"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "PRIVATE_KEY detected" in result.findings

    def test_detects_openssh_private_key(self):
        content = (
            "-----BEGIN OPENSSH PRIVATE KEY-----\n"
            "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUA...\n"
            "-----END OPENSSH PRIVATE KEY-----"
        )
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "PRIVATE_KEY detected" in result.findings

    # ---- Bearer tokens ----

    def test_detects_bearer_token(self):
        content = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.xyz"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "BEARER_TOKEN detected" in result.findings
        assert "[REDACTED-BEARER_TOKEN]" in result.redacted_content

    def test_detects_bearer_token_case_insensitive(self):
        content = "authorization: bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.xyz"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "BEARER_TOKEN detected" in result.findings

    def test_no_false_positive_on_bearer_english(self):
        content = "The bearer of good news arrived early."
        result = scan_tool_output(content)
        assert result.has_sensitive_content is False

    # ---- Connection strings ----

    def test_detects_connection_string(self):
        content = "DATABASE_URL=postgres://admin:s3cretP4ss@db.example.com:5432/mydb"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "CONNECTION_STRING detected" in result.findings
        assert "s3cretP4ss" not in result.redacted_content

    def test_detects_redis_connection_string(self):
        content = "redis://user:password123@redis.example.com:6379/0"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "CONNECTION_STRING detected" in result.findings

    def test_detects_connection_string_with_an_email_address_as_user(self):
        content = "EMAIL_URL=smtp://alerts@example.com:s3cretP4ss@smtp.example.com:587"
        result = scan_tool_output(content)
        assert result.findings == ["CONNECTION_STRING detected"]
        assert result.redacted_content == "EMAIL_URL=[REDACTED-CONNECTION_STRING]"

    # ---- URL templates: a placeholder where the password would stand ----

    @pytest.mark.parametrize(
        "content",
        [
            'DATABASE_URL = "postgresql+psycopg2://{user}:{password}@{host}:{port}/{db}"',
            'url = f"redis://default:{settings.redis_password}@{host}:6379/0"',
            'conn = "amqp://%s:%s@%s:5672/" % (user, pw, host)',
            'export PGURL="postgres://app:${DB_PASSWORD}@db.internal/app"',
            "# docs: mongodb://<user>:<password>@cluster0.example.net",
            "sqlalchemy.url = postgresql://%(DB_USER)s:%(DB_PASS)s@%(DB_HOST)s/app",
            "run: git clone https://x-access-token:${{secrets.GITHUB_TOKEN}}@github.com/o/r.git",
            'push = f"git push https://x-access-token:{token}@github.com/o/r"',
            # empty and positional braces, capitals, a dotted name in two cases
            'let url = format!("postgres://{}:{}@{}:5432/app", user, pw, host);',
            'url = "postgres://{0}:{1}@{2}/app".format(user, pw, host)',
            "MONGO_URI=mongodb+srv://<USERNAME>:<YOUR_PASSWORD>@cluster0.example.net/app",
            'url = f"postgresql://{settings.DB_USER}:{settings.DB_PASSWORD}@{settings.DB_HOST}/app"',
            # doubled braces without "$", a dash inside <...>, %v
            "url: redis://default:{{redis_password}}@{{redis_host}}:6379",
            "mongodb+srv://<db-user>:<your-password>@cluster0.example.net",
            'dsn := fmt.Sprintf("postgres://%v:%v@%v/app", user, pass, host)',
        ],
    )
    def test_url_template_with_a_placeholder_password_is_left_as_it_is(self, content):
        # Source code and documentation, not a credential. The agent reads
        # files through this scanner: a marker in place of such a line keeps
        # it from editing the line and can end up in what it writes.
        result = scan_tool_output(content)
        assert result.findings == []
        assert result.redacted_content == content

    @pytest.mark.parametrize(
        ("content", "redacted"),
        [
            (
                'DATABASE_URL = "postgresql+psycopg2://{user}:s3cretP4ss@{host}:{port}/{db}"',
                'DATABASE_URL = "[REDACTED-CONNECTION_STRING]"',
            ),
            (
                'url = f"redis://default:s3cretP4ss@{host}:6379/0"',
                'url = f"[REDACTED-CONNECTION_STRING]"',
            ),
            (
                'conn = "amqp://%s:s3cretP4ss@%s:5672/" % (user, host)',
                'conn = "[REDACTED-CONNECTION_STRING]" % (user, host)',
            ),
            (
                'export PGURL="postgres://app:s3cretP4ss@db.internal/app"',
                'export PGURL="[REDACTED-CONNECTION_STRING]"',
            ),
            (
                "# docs: mongodb://<user>:s3cretP4ss@cluster0.example.net",
                "# docs: [REDACTED-CONNECTION_STRING]",
            ),
            (
                "sqlalchemy.url = postgresql://%(DB_USER)s:s3cretP4ss@%(DB_HOST)s/app",
                "sqlalchemy.url = [REDACTED-CONNECTION_STRING]",
            ),
            (
                "run: git clone https://x-access-token:s3cretP4ss@github.com/o/r.git",
                "run: git clone https://[REDACTED-GITHUB_URL_TOKEN]github.com/o/r.git",
            ),
        ],
    )
    def test_same_url_with_a_password_in_the_place_of_the_placeholder_is_replaced(
        self, content, redacted
    ):
        assert scan_tool_output(content).redacted_content == redacted

    @pytest.mark.parametrize(
        "password",
        [
            # only begins or ends with a placeholder
            "{x}real",
            "${A}b3",
            "%sabc",
            "<a>b",
            "{{x}}y",
            "%(x)sy",
            "real{x}",
            "{a}{b}",
            # forms that are not taken: a real password can look like them
            "$DB_PASSWORD",
            "${DB_PASSWORD:-postgres}",
            "${DB_PASSWORD-postgres}",
            "[password]",
            "password",
            "%d",
            "<pass.word>",
            # a password that somebody left the brackets of a placeholder around
            # (MongoDB Atlas hands out "<password>"): it holds a digit, or it
            # mixes small letters and capitals inside <...>
            "<" + _LETTERS_AND_DIGITS + ">",
            "{" + _LETTERS_AND_DIGITS + "}",
            "${" + _LETTERS_AND_DIGITS + "}",
            "{" + "123456" + "}",
            "<" + "Sunshine" + "LetMeIn" + ">",
        ],
    )
    def test_password_that_is_not_one_placeholder_and_nothing_else_is_replaced(self, password):
        url = f"postgres://app:{password}@db.internal/app"
        assert scan_tool_output(url).redacted_content == "[REDACTED-CONNECTION_STRING]"
        git_url = f"https://x-access-token:{password}@github.com/o/r.git"
        redacted = "https://[REDACTED-GITHUB_URL_TOKEN]github.com/o/r.git"
        assert scan_tool_output(git_url).redacted_content == redacted

    def test_placeholder_password_after_an_aws_key_id_is_no_template(self):
        # The key id is real and is replaced: the URL goes as a whole, as before.
        content = "https://AKIAIOSFODNN7EXAMPLE:{secret}@files.example.com/x"
        assert scan_tool_output(content).redacted_content == "[REDACTED-CONNECTION_STRING]"

    def test_connection_string_no_catastrophic_backtracking(self):
        """Protocol-name cap prevents pathological regex time."""
        import time

        content = "a" * 50 + "://" + "b" * 10000 + ":c@d"
        start = time.monotonic()
        scan_tool_output(content)
        elapsed_ms = (time.monotonic() - start) * 1000
        assert elapsed_ms < 1000

    # ---- Multiple findings ----

    def test_detects_multiple_secrets(self):
        content = (
            "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n"
            "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n"
        )
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert len(result.findings) >= 2
        assert "AKIAIOSFODNN7EXAMPLE" not in result.redacted_content
        assert "ghp_" not in result.redacted_content

    # ---- Surrounding content preserved ----

    def test_preserves_surrounding_content(self):
        content = "before AKIAIOSFODNN7EXAMPLE after"
        result = scan_tool_output(content)
        assert result.redacted_content == "before [REDACTED-AWS_KEY] after"

    # ---- Clean content (no false positives) ----

    def test_clean_code_output(self):
        content = "def hello():\n    return 'world'\n"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is False
        assert result.redacted_content == content
        assert result.findings == []

    def test_clean_test_output(self):
        content = "PASSED tests/test_main.py::test_hello - 3 passed in 0.5s"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is False

    def test_clean_git_output(self):
        content = (
            "commit abc123\n"
            "Author: User <user@example.com>\n"
            "Date: Mon Jan 1\n"
            "\n"
            "    feat: add feature"
        )
        result = scan_tool_output(content)
        assert result.has_sensitive_content is False

    def test_clean_url_without_password(self):
        content = "https://github.com/owner/repo/pull/42"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is False

    def test_clean_url_followed_by_an_email_address(self):
        # A colon and an "@" somewhere after a URL do not make it a
        # user:password@host URL.
        content = "See https://example.com/docs\nAuthor: User <user@example.com>\n"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is False
        assert result.redacted_content == content

    def test_clean_url_with_port_and_scoped_package(self):
        content = "GET https://registry.example.com:8443/@acme/pkg 200"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is False
        assert result.redacted_content == content

    # ---- Edge cases ----

    def test_empty_string(self):
        result = scan_tool_output("")
        assert result.has_sensitive_content is False
        assert result.redacted_content == ""
        assert result.findings == []

    def test_none_input(self):
        result = scan_tool_output(None)
        assert result.has_sensitive_content is False
        assert result.redacted_content == ""

    def test_non_string_converted(self):
        # Caller is expected to convert, but scan_tool_output handles str only
        result = scan_tool_output(str({"key": "AKIAIOSFODNN7EXAMPLE"}))
        assert result.has_sensitive_content is True
        assert "AWS_KEY detected" in result.findings

    def test_large_output(self):
        # Should not hang or error on large output
        content = "a" * 1_000_000
        result = scan_tool_output(content)
        assert result.has_sensitive_content is False
        assert result.duration_ms >= 0

    def test_duration_is_recorded(self):
        content = "AKIAIOSFODNN7EXAMPLE"
        result = scan_tool_output(content)
        assert result.duration_ms >= 0
