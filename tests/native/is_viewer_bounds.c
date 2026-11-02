/* ROM-free regression for the CVE-2025-9688 backport. */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "device/cart/is_viewer.h"
#include "api/callbacks.h"

static unsigned warnings;
void DebugMessage(int level, const char *message, ...)
{
    (void)message;
    assert(level == M64MSG_WARNING);
    ++warnings;
}

static void rejected(uint32_t pos, uint32_t count)
{
    struct is_viewer viewer;
    poweron_is_viewer(&viewer);
    memset(viewer.data, 'x', sizeof(viewer.data));
    memset(viewer.output_buffer, 'y', sizeof(viewer.output_buffer));
    viewer.buffer_pos = pos;
    unsigned before = warnings;
    write_is_viewer(&viewer, 0x14, count, UINT32_MAX);
    assert(warnings == before + 1);
    assert(viewer.buffer_pos == 0);
    for (size_t i = 0; i < IS_BUFFER_SIZE; ++i) {
        assert(viewer.output_buffer[i] == 0);
        assert(viewer.data[i] == 'x');
    }
}

int main(void)
{
    struct is_viewer viewer;
    poweron_is_viewer(&viewer);
    /* Small writes still append, respecting the write mask. */
    memcpy(viewer.data + 0x20, "abcd", 4);
    write_is_viewer(&viewer, 0x14, 0xffff0004, 0xffff);
    write_is_viewer(&viewer, 0x14, 4, UINT32_MAX);
    assert(viewer.buffer_pos == 8);
    assert(memcmp(viewer.output_buffer, "abcdabcd", 8) == 0);
    write_is_viewer(&viewer, 0x14, UINT32_MAX, 0);
    assert(viewer.buffer_pos == 8 && warnings == 0);

    /* The exact destination boundary is allowed; no overlapping source copy. */
    poweron_is_viewer(&viewer);
    memset(viewer.data + 0x20, 'a', 32);
    viewer.buffer_pos = IS_BUFFER_SIZE - 32;
    write_is_viewer(&viewer, 0x14, 32, UINT32_MAX);
    assert(viewer.buffer_pos == IS_BUFFER_SIZE);
    assert(memcmp(viewer.output_buffer + IS_BUFFER_SIZE - 32,
                  viewer.data + 0x20, 32) == 0);
    assert(warnings == 0);

    rejected(IS_BUFFER_SIZE, 1);             /* destination exhausted */
    rejected(0, IS_BUFFER_SIZE + 1);         /* length too large */
    rejected(IS_BUFFER_SIZE + 1, 1);         /* invalid saved position */
    rejected(1, UINT32_MAX);                 /* length addition wraps */
    rejected(UINT32_MAX, 1);                 /* position addition wraps */
    rejected(UINT32_MAX, UINT32_MAX);        /* both operands invalid */
    puts("PASS: normal/masked/zero/exact-boundary writes and 6 rejected bounds cases");
    return 0;
}
