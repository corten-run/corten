package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
)

// encoding/json accepts missing/null non-pointer fields as zero values. Alert
// writes require the non-nullable fields declared by the native record types.
func alertRecordFields(data json.RawMessage, kind reflect.Type) error {
	missing := len(data) == 0 || bytes.Equal(bytes.TrimSpace(data), []byte("null"))
	if kind.Kind() == reflect.Pointer {
		if missing {
			return nil
		}
		return alertRecordFields(data, kind.Elem())
	}
	if missing {
		return fmt.Errorf("missing required marketplace field")
	}
	switch kind.Kind() {
	case reflect.Struct:
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(data, &fields); err != nil {
			return err
		}
		for i := 0; i < kind.NumField(); i++ {
			field := kind.Field(i)
			name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
			if name == "" {
				name = field.Name
			}
			if name == "-" || !field.IsExported() {
				continue
			}
			if err := alertRecordFields(fields[name], field.Type); err != nil {
				return err
			}
		}
	case reflect.Slice:
		var rows []json.RawMessage
		if err := json.Unmarshal(data, &rows); err != nil {
			return err
		}
		for _, row := range rows {
			if err := alertRecordFields(row, kind.Elem()); err != nil {
				return err
			}
		}
	}
	return nil
}
