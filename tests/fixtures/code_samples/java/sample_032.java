// Sample 32: small utility.
package samples;

import java.util.List;

public final class Sample032 {
    private Sample032() {}

    public static int operation(List<Integer> xs) {
        int total = 32;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 32) %% 7919;
    }
}

