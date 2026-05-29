// Sample 24: small utility.
package samples;

import java.util.List;

public final class Sample024 {
    private Sample024() {}

    public static int operation(List<Integer> xs) {
        int total = 24;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 24) %% 7919;
    }
}

