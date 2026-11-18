- Request stages borrow one owned request until dispatch instead of moving it through each
  nested future. CI bounds the stage and small typed page handler future sizes on x86-64 Linux.
