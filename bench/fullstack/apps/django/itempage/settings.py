# Django's native sessions and ORM persist marketplace alerts across Gunicorn workers.
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.environ.get("SECRET_KEY", "bench-only-not-secret")
DEBUG = False
ALLOWED_HOSTS = ["*"]
INSTALLED_APPS = ["django.contrib.staticfiles", "django.contrib.humanize", "django.contrib.sessions", "itempage.apps.CatalogConfig"]
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "alerts.sqlite3"}}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
SESSION_COOKIE_AGE = 1800
SESSION_COOKIE_SECURE = os.environ.get("SESSION_COOKIE_SECURE") == "1"
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
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

# Keep the default benchmark profile unchanged; production qualification opts in.
if os.environ.get("PROFILE") == "matched":
    from django.middleware.csp import CSP

    ALLOWED_HOSTS = os.environ.get("HOSTS", "localhost,127.0.0.1").split(",")
    SECURE_CSP = {
        "default-src": [CSP.SELF],
        "script-src": [CSP.SELF],
        "style-src": [CSP.SELF],
        "object-src": [CSP.NONE],
        "base-uri": [CSP.SELF],
        "frame-ancestors": [CSP.NONE],
        "form-action": [CSP.SELF],
    }
    DATA_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024
    MIDDLEWARE[1:1] = ["django.middleware.csp.ContentSecurityPolicyMiddleware"]
    # Validate hosts before WhiteNoise can short-circuit a static request.
    MIDDLEWARE.remove("django.middleware.common.CommonMiddleware")
    MIDDLEWARE.insert(2, "django.middleware.common.CommonMiddleware")
    MIDDLEWARE[4:4] = [
        "django.middleware.gzip.GZipMiddleware",
        "itempage.production.ProductionHeadersMiddleware",
    ]
