from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True
    dependencies = [("sessions", "0001_initial")]
    operations = [migrations.CreateModel(
        name="Alert",
        fields=[
            ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
            ("item_id", models.TextField()),
            ("email", models.TextField()),
            ("target_minor", models.BigIntegerField()),
            ("session", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="sessions.session")),
        ],
        options={"ordering": ["id"]},
    )]
