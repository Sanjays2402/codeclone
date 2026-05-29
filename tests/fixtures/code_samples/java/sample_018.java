// Sample 18: small utility.
package samples;

import java.util.List;

public final class Sample018 {
    private Sample018() {}

    public static int operation(List<Integer> xs) {
        int total = 18;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 18) %% 7919;
    }
}

