<?php

namespace App\Support;

use Brick\Math\BigDecimal;
use Brick\Math\Exception\MathException;
use Brick\Math\RoundingMode;
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

        // ICU validates the locale; its PHP parse API returns a double, not the
        // decimal needed for exact half-up cents and signed-64-bit boundaries.
        $decimal = str_replace([
            $this->parser->getSymbol(NumberFormatter::GROUPING_SEPARATOR_SYMBOL),
            $this->parser->getSymbol(NumberFormatter::DECIMAL_SEPARATOR_SYMBOL),
            $this->parser->getSymbol(NumberFormatter::MINUS_SIGN_SYMBOL),
            $this->parser->getSymbol(NumberFormatter::PLUS_SIGN_SYMBOL),
            $this->parser->getSymbol(NumberFormatter::EXPONENTIAL_SYMBOL), "\u{2212}",
        ], ['', '.', '-', '+', 'E', '-'], $target);
        $decimal = preg_replace('/[\p{Z}\s\p{Cf}]/u', '', $decimal);
        try {
            $minor = BigDecimal::of($decimal)->multipliedBy(100)->toScale(0, RoundingMode::HalfUp)->toInt();
        } catch (MathException) {
            return [$this->labels['invalid_price'], null];
        }

        // Format the whole units as an ICU int64, then insert the exact cents.
        // Converting the rounded integer back to double would lose large cents.
        $this->currency->setTextAttribute(NumberFormatter::CURRENCY_CODE, 'USD');
        $price = $this->currency->format(intdiv($minor, 100), NumberFormatter::TYPE_INT64);
        $separator = $this->currency->getSymbol(NumberFormatter::MONETARY_SEPARATOR_SYMBOL);
        $price = substr_replace($price, str_pad((string) ($minor % 100), 2, '0', STR_PAD_LEFT), strrpos($price, $separator) + strlen($separator), 2);

        return [strtr($this->labels['alert_set'], ['{email}' => $email, '{title}' => $title, '{price}' => $price]), $minor];
    }
}
