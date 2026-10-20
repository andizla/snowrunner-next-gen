; The texture base rule's value and its reader as the game has them (SnowRunner.exe build 6a607c05, rva 0x14d8037):
; mov ecx,[rip+disp32]; mov eax,ecx; cdq; sub eax,edx; sar eax,1 on an int of 512. shadow_test links this, so on a
; build the DLL has no addresses for (this program) it has to find the int by the reader when the device is made.
.data
texSmall DD 512

.code
; half the value: 256 as the game ships it, 128 once the rule has set it
TexSmallHalf PROC
    mov ecx, DWORD PTR texSmall
    mov eax, ecx
    cdq
    sub eax, edx
    sar eax, 1
    ret
TexSmallHalf ENDP
END
