<?php

namespace App\Support;

use InvalidArgumentException;
use JsonSerializable;

final readonly class CatalogRecord implements JsonSerializable
{
    /**
     * @param list<string> $tags
     * @param list<array{name: string, value: string}> $fields
     * @param list<array{id: string, title: string}> $related
     */
    private function __construct(
        public string $id,
        public string $title,
        public string $subtitle,
        public string $description,
        public array $tags,
        public array $fields,
        public array $related,
    ) {}

    public static function fromArray(array $value): self
    {
        $textKeys = ['id', 'title', 'subtitle', 'description'];
        $keys = [...$textKeys, 'tags', 'fields', 'related'];
        if (count($value) !== count($keys) || array_diff($keys, array_keys($value))) {
            throw new InvalidArgumentException('Invalid catalog record');
        }
        self::strings(array_intersect_key($value, array_flip($textKeys)), $textKeys);
        foreach (['tags', 'fields', 'related'] as $key) {
            if (! is_array($value[$key]) || ! array_is_list($value[$key])) {
                throw new InvalidArgumentException('Catalog lists must be arrays');
            }
        }
        foreach ($value['tags'] as $tag) {
            if (! is_string($tag)) {
                throw new InvalidArgumentException('Catalog tags must be strings');
            }
        }
        foreach ($value['fields'] as $field) {
            self::strings($field, ['name', 'value']);
        }
        foreach ($value['related'] as $row) {
            self::strings($row, ['id', 'title']);
        }

        return new self(...$value);
    }

    private static function strings(mixed $value, array $keys): void
    {
        if (! is_array($value) || count($value) !== count($keys) || array_diff($keys, array_keys($value))) {
            throw new InvalidArgumentException('Invalid catalog text object');
        }
        foreach ($keys as $key) {
            if (! is_string($value[$key])) {
                throw new InvalidArgumentException('Catalog text must be strings');
            }
        }
    }

    public function jsonSerialize(): array
    {
        return get_object_vars($this);
    }
}
