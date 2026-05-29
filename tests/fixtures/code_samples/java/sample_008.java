// Sample 8: small utility.
package samples;

import java.util.List;

public final class Sample008 {
    private Sample008() {}

    public static int operation(List<Integer> xs) {
        int total = 8;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 8) %% 7919;
    }
}

