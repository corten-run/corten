from django.http import Http404, JsonResponse
from django.shortcuts import render
from django.views.decorators.http import require_GET

from .catalog import source


@require_GET
def show(request, record_id):
    record = source.get(record_id)
    if record is None:
        raise Http404
    prefix = request.GET.get("field", "")
    return render(request, "catalog.html", {
        "record": record,
        "prefix": prefix,
        "fields": [field for field in record.fields if field.name.startswith(prefix)],
    })


@require_GET
def record_json(request, record_id):
    record = source.get(record_id)
    if record is None:
        raise Http404
    return JsonResponse(record.to_dict())
