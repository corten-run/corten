<?php

namespace App\Support;

use MessageFormatter;
use NumberFormatter;

final class MarketplaceFormat
{
    public const LOCALES = ['en-US', 'fr-FR', 'de-DE'];

    public readonly array $labels;
    private NumberFormatter $currency;
    private NumberFormatter $integer;
    private NumberFormatter $rating;
    private NumberFormatter $parser;
    private MessageFormatter $plurals;

    public function __construct(string $locale)
    {
        static $catalog;
        $catalog ??= json_decode(file_get_contents(resource_path('marketplace_labels.json')), true, flags: JSON_THROW_ON_ERROR);
        $this->labels = $catalog[$locale];
        $this->currency = new NumberFormatter($locale, NumberFormatter::CURRENCY);
        $this->currency->setAttribute(NumberFormatter::MIN_FRACTION_DIGITS, 2);
        $this->currency->setAttribute(NumberFormatter::MAX_FRACTION_DIGITS, 2);
        $this->currency->setAttribute(NumberFormatter::ROUNDING_MODE, NumberFormatter::ROUND_HALFUP);
        $this->integer = new NumberFormatter($locale, NumberFormatter::DECIMAL);
        $this->integer->setAttribute(NumberFormatter::MAX_FRACTION_DIGITS, 0);
        $this->rating = new NumberFormatter($locale, NumberFormatter::DECIMAL);
        $this->rating->setAttribute(NumberFormatter::MIN_FRACTION_DIGITS, 0);
        $this->rating->setAttribute(NumberFormatter::MAX_FRACTION_DIGITS, 1);
        $this->rating->setAttribute(NumberFormatter::ROUNDING_MODE, NumberFormatter::ROUND_HALFUP);
        $this->parser = new NumberFormatter($locale, NumberFormatter::DECIMAL);
        $this->parser->setAttribute(NumberFormatter::LENIENT_PARSE, 0);
        $this->plurals = new MessageFormatter($locale, '{n, plural, one {'.$this->labels['listing_one'].'} many {'.$this->labels['listing_many'].'} other {'.$this->labels['listing_other'].'}}');
    }

    public function money(?int $minor): string
    {
        return $minor === null ? "\u{2014}" : $this->amount($minor / 100);
    }

    public function amount(float $value): string
    {
        return $this->currency->formatCurrency($value, 'USD');
    }

    public function number(int $value): string
    {
        return $this->integer->format($value);
    }

    public function rating(int $hundredths): string
    {
        return $this->rating->format($hundredths / 100);
    }

    public function count(int $value): string
    {
        return $this->number($value).' '.$this->plurals->format(['n' => $value]);
    }

    public function alert(string $email, string $target, string $title): string
    {
        return $this->alertResult($email, $target, $title)[0];
    }

    public function alertResult(string $email, string $target, string $title): array
    {
        if (! str_contains($email, '@')) {
            return [$this->labels['invalid_email'], null];
        }
        $position = 0;
        $amount = $this->parser->parse($target, NumberFormatter::TYPE_DOUBLE, $position);
        $length = preg_match_all('/./us', $target);
        if ($amount === false || ! is_finite($amount) || $amount <= 0 || $position !== $length) {
            return [$this->labels['invalid_price'], null];
        }

        $minor = round($amount * 100, 0, PHP_ROUND_HALF_UP);
        if (! is_finite($minor) || $minor >= PHP_INT_MAX) {
            return [$this->labels['invalid_price'], null];
        }

        return [strtr($this->labels['alert_set'], ['{email}' => $email, '{title}' => $title, '{price}' => $this->amount($amount)]), (int) $minor];
    }
}
