# Django's startproject settings for production, without the parts that need a database
# (sessions, auth, messages, admin). CSRF protection is on, as by default.
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.environ.get("SECRET_KEY", "bench-only-not-secret")
DEBUG = False
ALLOWED_HOSTS = ["*"]
INSTALLED_APPS = ["django.contrib.staticfiles", "django.contrib.humanize", "itempage.apps.CatalogConfig"]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "itempage.urls"
TEMPLATES = [{"BACKEND": "django.template.backends.django.DjangoTemplates", "DIRS": [BASE_DIR / "templates"], "OPTIONS": {}}]
WSGI_APPLICATION = "itempage.wsgi.application"
LANGUAGE_CODE = "en-us"
USE_I18N = True
USE_TZ = True
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "static"]
STORAGES = {"staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"}}

# The matched tier's production profile (PROFILE=matched, bench/fullstack/README.md, "The matched
# tier"), from Django's own middleware and settings: the names it answers to (localhost and the
# deploy's HOSTS, as Corten's host check), a CSP (Django's own, `SECURE_CSP`), gzip when asked,
# and an ETag with a 304 (`ConditionalGetMiddleware`). urls.py marks the pages and the JSON
# private with `cache_control`. Its forms already take at most 2.5 MB (`DATA_UPLOAD_MAX_MEMORY_SIZE`)
# and refuse a cross-site post (CSRF); SecurityMiddleware and XFrameOptionsMiddleware already send
# the other security headers. Django has no setting for Permissions-Policy.
PROFILE = os.environ.get("PROFILE") == "matched"
if PROFILE:
    from django.utils.csp import CSP

    hosts = [h.strip() for h in os.environ.get("HOSTS", "").split(",") if h.strip()]
    ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]", *hosts]
    SECURE_CSP = {
        "default-src": [CSP.SELF],
        "script-src": [CSP.SELF],
        "style-src": [CSP.SELF],
        "img-src": [CSP.SELF, "data:", "https:"],
        "object-src": [CSP.NONE],
        "base-uri": [CSP.SELF],
        "form-action": [CSP.SELF],
        "frame-ancestors": [CSP.NONE],
    }
    MIDDLEWARE = [
        "django.middleware.security.SecurityMiddleware",
        "whitenoise.middleware.WhiteNoiseMiddleware",
        "django.middleware.gzip.GZipMiddleware",
        "django.middleware.http.ConditionalGetMiddleware",
        "django.middleware.csp.ContentSecurityPolicyMiddleware",
        "django.middleware.common.CommonMiddleware",
        "django.middleware.csrf.CsrfViewMiddleware",
        "django.middleware.clickjacking.XFrameOptionsMiddleware",
    ]
