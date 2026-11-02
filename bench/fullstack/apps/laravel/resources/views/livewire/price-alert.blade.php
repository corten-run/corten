<section class="item-detail__panel">
<h2>Price alert</h2>
<div class="alert-form__form"><form method="post" wire:submit="save">
<input type="hidden" name="item_id" value="{{ $itemId }}"><input type="hidden" name="title" value="{{ $title }}">
<label>Email<input type="email" name="email" wire:model="email" required></label>
<label>Alert me below<input type="text" name="target_price" wire:model="target_price" inputmode="decimal" required></label>
<button type="submit">Set alert</button></form></div>
<p class="alert-form__message" id="alert-message" aria-live="polite">{{ $message }}</p>
</section>
