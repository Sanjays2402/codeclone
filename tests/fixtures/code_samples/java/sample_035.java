// Sample 35: small utility.
package samples;

import java.util.List;

public final class Sample035 {
    private Sample035() {}

    public static int operation(List<Integer> xs) {
        int total = 35;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 35) %% 7919;
    }
}

