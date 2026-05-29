// Sample 37: small utility.
package samples;

import java.util.List;

public final class Sample037 {
    private Sample037() {}

    public static int operation(List<Integer> xs) {
        int total = 37;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 37) %% 7919;
    }
}

