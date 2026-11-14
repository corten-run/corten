<?php

return [
    'default' => 'reverb',
    'connections' => [
        'reverb' => [
            'driver' => 'reverb',
            'key' => env('REVERB_APP_KEY'),
            'secret' => env('REVERB_APP_SECRET'),
            'app_id' => env('REVERB_APP_ID'),
            'options' => ['host' => '127.0.0.1', 'port' => 8081, 'scheme' => 'http', 'useTLS' => false],
            'client_options' => ['timeout' => 5, 'connect_timeout' => 2],
        ],
    ],
];
