from django.contrib.sessions.models import Session
from django.db import models


class Alert(models.Model):
    session = models.ForeignKey(Session, on_delete=models.CASCADE)
    item_id = models.TextField()
    email = models.TextField()
    target_minor = models.BigIntegerField()

    class Meta:
        ordering = ["id"]
